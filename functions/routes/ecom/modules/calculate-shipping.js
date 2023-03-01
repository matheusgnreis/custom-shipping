exports.post = ({ appSdk }, req, res) => {
  /**
   * Treat `params` and (optionally) `application` from request body to properly mount the `response`.
   * JSON Schema reference for Calculate Shipping module objects:
   * `params`: https://apx-mods.e-com.plus/api/v1/calculate_shipping/schema.json?store_id=100
   * `response`: https://apx-mods.e-com.plus/api/v1/calculate_shipping/response_schema.json?store_id=100
   *
   * Examples in published apps:
   * https://github.com/ecomplus/app-mandabem/blob/master/functions/routes/ecom/modules/calculate-shipping.js
   * https://github.com/ecomplus/app-datafrete/blob/master/functions/routes/ecom/modules/calculate-shipping.js
   * https://github.com/ecomplus/app-jadlog/blob/master/functions/routes/ecom/modules/calculate-shipping.js
   */

  const { params, application } = req.body
    // app configured options
    const config = Object.assign({}, application.data, application.hidden_data)

    // start mounting response body
    // https://apx-mods.e-com.plus/api/v1/calculate_shipping/response_schema.json?store_id=100
    const response = {
      shipping_services: []
    }
    let shippingRules
    if (Array.isArray(config.shipping_rules) && config.shipping_rules.length) {
      shippingRules = config.shipping_rules
    } else {
      // anything to do without shipping rules
      res.send(response)
      return
    }

    if (Array.isArray(config.services) && config.services.length && shippingRules && shippingRules.length) {
      const newShippingRules = shippingRules.map(rule => {
        const foundService = config.services.find(service => service.service_code === rule.service_code)
        ['free_shipping_all', 'product_ids'].forEach(prop => {
          rule[prop] = foundService[prop]
        })
        return rule
      })
      shippingRules = newShippingRules
    }
    const destinationZip = params.to ? params.to.zip.replace(/\D/g, '') : ''
    let originZip = params.from
      ? params.from.zip
      : config.zip ? config.zip : ''

    const checkZipCode = rule => {
      // validate rule zip range
      if (destinationZip && rule.zip_range) {
        const { min, max } = rule.zip_range
        return Boolean((!min || destinationZip >= min) && (!max || destinationZip <= max))
      }
      return true
    }

    // search for configured free shipping rule and origin zip by rule
    for (let i = 0; i < shippingRules.length; i++) {
      const rule = shippingRules[i]
      console.log('Rule', JSON.stringify(rule))
      if (
        checkZipCode(rule) &&
        !rule.total_price &&
        !rule.disable_free_shipping_from &&
        !(rule.excedent_weight_cost > 0) &&
        !(rule.amount_tax > 0)
      ) {
        if (!originZip && rule.from && rule.from.zip) {
          originZip = rule.from.zip
        }
        if (!rule.min_amount) {
          response.free_shipping_from_value = 0
          if (originZip) {
            break
          }
        } else if (!(response.free_shipping_from_value <= rule.min_amount)) {
          response.free_shipping_from_value = rule.min_amount
        }
      }
    }

    // params object follows calculate shipping request schema:
    // https://apx-mods.e-com.plus/api/v1/calculate_shipping/schema.json?store_id=100
    if (!params.to) {
      // respond only with free shipping option
      res.send(response)
      return
    }

    if (!originZip) {
      // must have configured origin zip code to continue
      const rule = shippingRules.find(rule => Boolean(checkZipCode(rule) && rule.from && rule.from.zip))
      if (rule) {
        originZip = rule.from.zip
      }
      if (!originZip) {
        return res.status(400).send({
          error: 'CALCULATE_ERR',
          message: 'Zip code is unset on app hidden data (merchant must configure the app)'
        })
      }
    }

    // calculate weight and pkg value from items list
    let amount = params.subtotal || 0
    if (params.items) {
      let finalWeight = 0
      params.items.forEach(({ price, quantity, dimensions, weight }) => {
        let physicalWeight = 0
        let cubicWeight = 1
        if (!params.subtotal) {
          amount += price * quantity
        }

        // sum physical weight
        if (weight && weight.value) {
          switch (weight.unit) {
            case 'kg':
              physicalWeight = weight.value
              break
            case 'g':
              physicalWeight = weight.value / 1000
              break
            case 'mg':
              physicalWeight = weight.value / 1000000
          }
        }

        // sum total items dimensions to calculate cubic weight
        if (dimensions) {
          const sumDimensions = {}
          for (const side in dimensions) {
            const dimension = dimensions[side]
            if (dimension && dimension.value) {
              let dimensionValue
              switch (dimension.unit) {
                case 'cm':
                  dimensionValue = dimension.value
                  break
                case 'm':
                  dimensionValue = dimension.value * 100
                  break
                case 'mm':
                  dimensionValue = dimension.value / 10
              }
              // add/sum current side to final dimensions object
              if (dimensionValue) {
                sumDimensions[side] = sumDimensions[side]
                  ? sumDimensions[side] + dimensionValue
                  : dimensionValue
              }
            }
          }

          // calculate cubic weight
          // https://suporte.boxloja.pro/article/82-correios-calculo-frete
          // (C x L x A) / 6.000
          for (const side in sumDimensions) {
            if (sumDimensions[side]) {
              cubicWeight *= sumDimensions[side]
            }
          }
          if (cubicWeight > 0) {
            cubicWeight /= 6000
          }
        }
        finalWeight += (quantity * (cubicWeight < 5 || physicalWeight > cubicWeight ? physicalWeight : cubicWeight))
      })

      // start filtering shipping rules
      const validShippingRules = shippingRules.filter(rule => {
        if (typeof rule === 'object' && rule) {
          return (!params.service_code || params.service_code === rule.service_code) &&
            checkZipCode(rule) &&
            (!rule.min_amount || amount >= rule.min_amount) &&
            (!rule.max_cubic_weight || rule.excedent_weight_cost > 0 || finalWeight <= rule.max_cubic_weight)
        }
        return false
      })

      if (validShippingRules.length) {
        // group by service code selecting lower price
        const shippingRulesByCode = validShippingRules.reduce((shippingRulesByCode, rule) => {
          console.log('Regra:', JSON.stringify(rule))
          if (typeof rule.total_price !== 'number') {
            rule.total_price = 0
          }
          if (typeof rule.price !== 'number') {
            rule.price = rule.total_price
          }
          if (rule.excedent_weight_cost > 0 && finalWeight > rule.max_cubic_weight) {
            rule.total_price += (rule.excedent_weight_cost * (finalWeight - rule.max_cubic_weight))
          }
          if (typeof rule.amount_tax === 'number' && !isNaN(rule.amount_tax)) {
            rule.total_price += (rule.amount_tax * amount / 100)
          }
          if (Array.isArray(rule.product_ids) && rule.product_ids.length) {
            const isFreeShippingAllProducts = rule.free_shipping_all || false 
            const hasProduct = isFreeShippingAllProducts
              ? params.items.every(item => rule.product_ids.indexOf(item.product_id) > -1)
              : params.items.some(item => rule.product_ids.indexOf(item.product_id) > -1)
            if (hasProduct) {
              rule.total_price = 0
            }
          }
          const serviceCode = rule.service_code
          const currentShippingRule = shippingRulesByCode[serviceCode]
          if (!currentShippingRule || currentShippingRule.total_price > rule.total_price) {
            shippingRulesByCode[serviceCode] = rule
          }
          return shippingRulesByCode
        }, {})

        // parse final shipping rules object to shipping services array
        for (const serviceCode in shippingRulesByCode) {
          const rule = shippingRulesByCode[serviceCode]
          if (rule) {
            let { label } = rule
            // delete filter properties from rule object
            delete rule.service_code
            delete rule.zip_range
            delete rule.min_amount
            delete rule.max_cubic_weight
            delete rule.excedent_weight_cost
            delete rule.amount_tax
            delete rule.label

            // also try to find corresponding service object from config
            let service
            if (Array.isArray(config.services)) {
              service = config.services.find(service => {
                return service && service.service_code === serviceCode
              })
              if (service && !label) {
                label = service.label
              }
            }
            if (!label) {
              label = serviceCode
            }

            response.shipping_services.push({
              // label, service_code, carrier (and maybe more) from service object
              ...service,
              service_code: serviceCode,
              label,
              shipping_line: {
                from: {
                  ...rule.from,
                  ...params.from,
                  zip: String((rule.from && rule.from.zip) || originZip).replace(/\D/g, '')
                },
                to: params.to,
                price: 0,
                total_price: 0,
                // price, total_price (and maybe more) from rule object
                ...rule,
                delivery_time: {
                  days: 20,
                  working_days: true,
                  ...rule.delivery_time
                },
                posting_deadline: {
                  days: 0,
                  ...config.posting_deadline,
                  ...rule.posting_deadline
                }
              }
            })
          }
        }
      }
    }

    // expecting to have response with shipping services here
    res.send(response)
}
